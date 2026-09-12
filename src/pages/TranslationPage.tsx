import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, LoaderCircle } from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { getTranslationWorkspace, type TranslationWorkspace } from '../lib/translation/repository'
import { SourcesPanel } from '../components/translation/SourcesPanel'
import { GlossaryPanel } from '../components/translation/GlossaryPanel'
import { StylePanel } from '../components/translation/StylePanel'
import { TranslationSetup } from '../components/translation/TranslationSetup'
import { NotFound } from './NotFoundPage'
import type { LibraryBook } from '../lib/books'
import '../styles/translation.css'

export function TranslationPage() {
  const { bookId } = useParams()
  const { books } = useLibrary()
  const book = books.find((entry) => entry.id === bookId)
  return book ? <TranslationView key={book.id} book={book} /> : <NotFound />
}

function TranslationView({ book }: { book: LibraryBook }) {
  const [workspace, setWorkspace] = useState<TranslationWorkspace>()
  const [error, setError] = useState('')
  const [parameters, setParameters] = useSearchParams()
  const requestedTab = parameters.get('tab')
  const tab = requestedTab === 'sources' ? 'metadata' : ['metadata', 'glossary', 'style'].includes(requestedTab ?? '') ? requestedTab : 'settings'
  const editing = useRef(false)
  const readWorkspace = useEffectEvent(() => getTranslationWorkspace(book))
  useEffect(() => {
    let cancelled = false
    let refreshing = false
    const load = () => {
      if (refreshing || editing.current || document.querySelector('dialog[open]')) return
      refreshing = true
      void readWorkspace()
      .then((data) => {
        if (!cancelled) {
          setWorkspace(data)
          setError('')
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : 'The translation workspace could not be loaded.',
          )
      }).finally(() => { refreshing = false })
    }
    const visible = () => { if (document.visibilityState === 'visible') load() }
    load()
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', visible)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [book.id, book.novelId])
  const refresh = async () => {
    const data = await getTranslationWorkspace(book)
    editing.current = false
    setWorkspace(data)
  }
  return (
    <main className="translation-page" onChangeCapture={() => { editing.current = true }}>
      <Link className="back-link" to={`/books/${book.id}`}>
        <ArrowLeft size={16} /> Back to book
      </Link>
      <div className="page-heading">
        <div>
          <h1>Translation</h1>
          <p>{book.title}</p>
        </div>
      </div>
      {workspace && (
        <>
          <div className="filter-tabs" role="tablist" aria-label="Translation workspace">
            {(['settings', 'style', 'glossary', 'metadata'] as const).map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                onClick={() => setParameters(previous => { const next = new URLSearchParams(previous); next.set('tab', name); return next })}
              >
                {name === 'settings'
                  ? 'Settings'
                  : name === 'metadata'
                    ? 'Metadata'
                    : name === 'glossary'
                      ? 'Glossary'
                      : 'Style Guide'}
              </button>
            ))}
          </div>
          {tab === 'settings' ? (
            <TranslationSetup
              key={workspace.translationSettings?.revision ?? 0}
              book={book}
              workspace={workspace}
              refresh={refresh}
            />
          ) : tab === 'metadata' ? (
            <>
              <TranslationSetup key={`metadata:${workspace.translationSettings?.revision ?? 0}`} book={book} workspace={workspace} refresh={refresh} view="metadata" />
              <SourcesPanel book={book} sources={workspace.sources} refresh={refresh} />
            </>
          ) : tab === 'glossary' ? (
            <GlossaryPanel
              book={book}
              entries={workspace.glossary}
              targetLanguage={workspace.translationSettings?.target_language ?? 'en'}
              refresh={refresh}
            />
          ) : (
            <StylePanel
              book={book}
              workspace={workspace}
              profiles={workspace.profiles}
              examples={workspace.examples}
              selectedId={workspace.novel.style_profile_id}
              referenceSourceId={workspace.translationSettings?.reference_source_id}
              refresh={refresh}
            />
          )}
        </>
      )}
      {!workspace && !error && (
        <div className="empty-inline" role="status">
          <LoaderCircle className="spin" size={22} /> Loading translation workspace...
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
