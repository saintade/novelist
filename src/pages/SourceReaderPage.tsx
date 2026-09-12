import { useEffect, useEffectEvent, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, LoaderCircle, Play, RefreshCw } from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { useSourceDirectory } from '../lib/sources/use-source-directory'
import '../styles/sources.css'
import { SourceTranslationReader } from '../components/reader/SourceTranslationReader'
import { downloadChapter, getSavedChapter, sourceInventory } from '../lib/sources/repository'
import { supabase } from '../lib/supabase/client'
import type { SourceDownloadResult, ReadingSource } from '../lib/sources/contracts'
import type { LibraryBook } from '../lib/books'
import { NotFound } from './NotFoundPage'

export function SourceReaderRoute() {
  const { bookId, sourceId, chapter } = useParams()
  const location = useLocation()
  const { books } = useLibrary()
  const book = books.find((entry) => entry.id === bookId)
  const directory = useSourceDirectory(book)
  if (!book) return <NotFound />
  if (directory.loading)
    return (
      <main className="source-reader-opening" role="status">
        Opening source...
      </main>
    )
  if (directory.error)
    return (
      <main className="source-reader-opening" role="alert">
        {directory.error}
      </main>
    )
  const source = directory.sources.find(
    (entry) => entry.id === sourceId && entry.role !== 'metadata',
  )
  const index = Number(chapter)
  if (!source || !Number.isInteger(index) || index < 0 || !sourceInventory(source)[index])
    return <NotFound />
  return (
    <SourceReading
      key={location.pathname}
      book={book}
      source={source}
      index={index}
    />
  )
}

function SourceReading({
  book,
  source,
  index,
}: {
  book: LibraryBook
  source: ReadingSource
  index: number
}) {
  const chapters = sourceInventory(source)
  const selected = chapters[index]
  const [result, setResult] = useState<SourceDownloadResult | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [savedStatus, setSavedStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [offsetUpdatedAt, setOffsetUpdatedAt] = useState(0)
  const run = async (confirmed: boolean) => {
    setBusy(true)
    setError('')
    try {
      setResult(await downloadChapter({ sourceId: source.id, url: selected.url, confirmed }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chapter could not be opened.')
    } finally {
      setBusy(false)
    }
  }
  const checkSaved = async (showMissing: boolean) => {
    if (checking) return
    setChecking(true)
    setSavedStatus('')
    try {
      const saved = await getSavedChapter(source.id, selected.url)
      if (saved) {
        setResult(saved)
        setError('')
      } else if (showMissing) setSavedStatus('Chapter not saved yet.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Saved chapter could not be read.')
    } finally {
      setChecking(false)
    }
  }
  const checkOnReturn = useEffectEvent(() => {
    void checkSaved(false)
  })
  const waitingForBrowser = result?.state === 'needs_browser'
  useEffect(() => {
    if (!waitingForBrowser) return
    const focus = () => checkOnReturn()
    const visible = () => {
      if (document.visibilityState === 'visible') checkOnReturn()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [waitingForBrowser])
  useEffect(() => {
    let cancelled = false
    Promise.all([
      downloadChapter({ sourceId: source.id, url: selected.url }),
      supabase.from('source_reading_progress').select('*').eq('source_id', source.id).maybeSingle(),
    ])
      .then(([download, progress]) => {
        if (!cancelled) {
          setResult(download)
          if (progress.data?.chapter_url === selected.url) {
            setOffset(progress.data.fraction)
            setOffsetUpdatedAt(Date.parse(progress.data.updated_at))
          }
        }
      })
      .catch((failure) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Chapter could not be opened.')
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [source.id, selected.url])
  const back = `/books/${book.id}?source=${source.id}`
  if (busy || error || result?.state !== 'ready')
    return (
      <main className="source-reader-opening">
        <Link className="back-link" to={back}>
          <ArrowLeft size={16} />
          Back to book
        </Link>
        <h1>{selected.title}</h1>
        <p>{source.label}</p>
        {busy ? (
          <p role="status">
            <LoaderCircle className="spin" size={18} />
            Downloading chapter...
          </p>
        ) : (
          <div role="alert">
            <p>{error || (result?.state !== 'ready' ? result?.message : '')}</p>
            {waitingForBrowser ? (
              <>
                <div className="source-reader-links">
                  <a
                    className="button primary"
                    href={source.url || selected.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`On the source page, open Novelist in Chrome/Edge, choose ${selected.title} in Chapter, then click Download chapter. Return here after it is saved.`}
                  >
                    <ExternalLink size={16} />
                    Open source in browser
                  </a>
                  <button
                    className="button"
                    disabled={checking}
                    title="Check this library for the chapter saved by the extension. Does not contact the source site or use AI."
                    onClick={() => void checkSaved(true)}
                  >
                    {checking ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                    Check saved chapter
                  </button>
                </div>
                {savedStatus && <p role="status">{savedStatus}</p>}
              </>
            ) : result?.state === 'needs_scraper' ? (
              <button className="button primary" onClick={() => void run(true)}>
                <Play size={16} />
                Allow up to 3 model requests
              </button>
            ) : (
              <button className="button" onClick={() => void run(false)}>
                Retry download
              </button>
            )}
            <div className="source-reader-links">
              {!waitingForBrowser && (
                <a href={source.url || selected.url} target="_blank" rel="noreferrer">
                  Open source for browser capture
                </a>
              )}
              <a href={selected.url} target="_blank" rel="noreferrer">
                Open source chapter
              </a>
            </div>
          </div>
        )}
      </main>
    )
  return (
    <SourceTranslationReader
      book={book}
      source={source}
      index={index}
      offset={offset}
      offsetUpdatedAt={offsetUpdatedAt}
      content={result.chapter}
      record={result.record}
    />
  )
}
