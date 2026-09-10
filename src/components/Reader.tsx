import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark as BookmarkIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  List,
  LoaderCircle,
  Moon,
  Search,
  Settings2,
  Sun,
  X,
} from 'lucide-react'
import { chapterTitle, type Chapter, type LibraryBook } from '../lib/books'
import { getChapter } from '../lib/library/repository'
import { writeSetting } from '../lib/preferences'
import { rememberPosition, restorePosition } from '../lib/reader/progress'
import { IconButton } from './ui'
import { ReadingSettings } from './reader/ReadingSettings'
import { ReaderContents } from './reader/ReaderContents'
import { initialSettings } from '../lib/reader/settings'
import { chapterMarkup } from '../lib/reader/markup'
import { readingTime } from '../lib/format'
import '../styles/reader.css'

interface ReaderProps {
  book: LibraryBook
  theme: 'light' | 'dark'
  onTheme: (theme: 'light' | 'dark') => void
  onProgress: (bookId: string, chapter: number, offset: number) => Promise<void>
  onBookmark: (
    bookId: string,
    chapter: number,
    offset: number,
    existingId?: string,
  ) => Promise<void>
  onFinish: (book: LibraryBook) => Promise<boolean>
}

export function Reader({ book, theme, onTheme, onProgress, onBookmark, onFinish }: ReaderProps) {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const index = Math.max(
    0,
    Math.min(book.chapters.length - 1, Number.parseInt(params.chapter ?? '0', 10) || 0),
  )
  const position = searchParams.get('at')
  const [chapter, setChapter] = useState<Chapter>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [panel, setPanel] = useState<'contents' | 'settings' | null>(null)
  const [finder, setFinder] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [activeMatch, setActiveMatch] = useState(0)
  const [offset, setOffset] = useState(0)
  const [settings, setSettings] = useState(initialSettings)
  const articleRef = useRef<HTMLElement>(null)
  const offsetRef = useRef(0)
  const trackRef = useRef(false)
  const restoreRef = useRef(restorePosition(book, index, position))
  const persist = useEffectEvent((bookId: string, chapterIndex: number, fraction: number) => {
    void onProgress(bookId, chapterIndex, fraction)
  })
  const checkpoint = useEffectEvent((fraction: number) => rememberPosition(book, index, fraction))

  useEffect(() => {
    let cancelled = false
    trackRef.current = false
    getChapter(book.id, index)
      .then((content) => {
        if (cancelled) return
        if (!content) throw new Error('This chapter is not available in local storage.')
        setChapter(content)
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'This chapter could not be opened.')
      })
    return () => {
      cancelled = true
    }
  }, [book.id, index, attempt])

  useEffect(() => {
    if (!chapter) return
    let cancelled = false
    let frame = 0
    const restore = () => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return
        const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
        offsetRef.current = restoreRef.current
        setOffset(restoreRef.current)
        window.scrollTo({ top: maximum * restoreRef.current, behavior: 'instant' })
        trackRef.current = true
        persist(book.id, index, restoreRef.current)
      })
    }
    if (document.fonts) void document.fonts.ready.then(restore)
    else restore()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [chapter, book.id, index])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    const handleScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!trackRef.current) return
        const maximum = document.documentElement.scrollHeight - window.innerHeight
        const fraction = maximum > 0 ? Math.min(1, Math.max(0, window.scrollY / maximum)) : 1
        offsetRef.current = fraction
        checkpoint(fraction)
        setOffset(fraction)
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (trackRef.current) persist(book.id, index, fraction)
        }, 400)
      })
    }
    const handleHide = () => {
      if (trackRef.current) checkpoint(offsetRef.current)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('pagehide', handleHide)
    document.addEventListener('visibilitychange', handleHide)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('pagehide', handleHide)
      document.removeEventListener('visibilitychange', handleHide)
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      if (trackRef.current) persist(book.id, index, offsetRef.current)
    }
  }, [book.id, index])

  useEffect(() => {
    writeSetting('novelist-reader', settings)
  }, [settings])
  useEffect(() => {
    document.title = `${chapterTitle(book.chapters[index].title)} | Novelist`
  }, [book, index])

  const goTo = (chapterIndex: number, at?: number) => {
    if (chapterIndex < 0 || chapterIndex >= book.chapters.length) return
    setPanel(null)
    navigate(`/read/${book.id}/${chapterIndex}${at !== undefined ? `?at=${at}` : ''}`)
  }

  const keyNavigation = useEffectEvent((event: KeyboardEvent) => {
    if (
      panel ||
      finder ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      (event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select') || event.target.isContentEditable))
    )
      return
    if (event.key === 'ArrowRight' && index < book.chapters.length - 1) {
      event.preventDefault()
      goTo(index + 1)
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      goTo(index - 1)
    }
  })
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyNavigation(event)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const rendered = chapter ? chapterMarkup(chapter, deferredQuery) : { html: '', matches: 0 }
  useEffect(() => {
    if (!deferredQuery) return
    const match = articleRef.current?.querySelector<HTMLElement>(
      `mark[data-match="${activeMatch}"]`,
    )
    match?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [deferredQuery, activeMatch])

  const bookmark = book.bookmarks.find(
    (saved) => saved.chapter === index && Math.abs(saved.offset - offset) < 0.05,
  )
  const font =
    settings.font === 'literata'
      ? 'Literata, Georgia, serif'
      : settings.font === 'manrope'
        ? 'Manrope, sans-serif'
        : 'Georgia, serif'

  return (
    <div
      className="reader"
      style={
        {
          '--reading-width': `${settings.width}px`,
          '--reading-size': `${settings.fontSize}px`,
          '--reading-line-height': settings.lineHeight,
          '--reading-font': font,
        } as CSSProperties
      }
    >
      <header className="reader-header">
        <Link className="reader-back" aria-label="Back to book details" to={`/books/${book.id}`}>
          <ArrowLeft size={19} />
          <span>Library</span>
        </Link>
        <div className="reader-title">
          <span>{book.title}</span>
          <small>{book.author}</small>
        </div>
        <div className="reader-tools">
          <IconButton
            label="Table of contents"
            className="contents-toggle"
            onClick={() => setPanel('contents')}
          >
            <List size={20} />
          </IconButton>
          <IconButton
            label="Find in chapter"
            aria-pressed={finder}
            onClick={() => {
              setFinder(!finder)
              setQuery('')
            }}
          >
            <Search size={19} />
          </IconButton>
          <IconButton
            label={bookmark ? 'Remove bookmark' : 'Bookmark this position'}
            className={bookmark ? 'is-selected' : ''}
            aria-pressed={Boolean(bookmark)}
            onClick={() => {
              void onBookmark(book.id, index, offset, bookmark?.id)
            }}
          >
            <BookmarkIcon size={19} fill={bookmark ? 'currentColor' : 'none'} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton label="Reading settings" onClick={() => setPanel('settings')}>
            <Settings2 size={19} />
          </IconButton>
          <IconButton
            className="theme-toggle"
            label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            onClick={() => onTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </IconButton>
        </div>
      </header>

      {finder && (
        <div className="reader-find">
          <Search size={17} />
          <input
            autoFocus
            aria-label="Find in chapter"
            placeholder="Find in chapter"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveMatch(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFinder(false)
                setQuery('')
              }
              if (event.key === 'Enter' && rendered.matches)
                setActiveMatch(
                  (activeMatch + (event.shiftKey ? rendered.matches - 1 : 1)) % rendered.matches,
                )
            }}
          />
          <span aria-live="polite">
            {query
              ? rendered.matches
                ? `${activeMatch + 1} / ${rendered.matches}`
                : 'No matches'
              : ''}
          </span>
          <IconButton
            label="Previous match"
            disabled={!rendered.matches}
            onClick={() => setActiveMatch((activeMatch + rendered.matches - 1) % rendered.matches)}
          >
            <ChevronUp size={17} />
          </IconButton>
          <IconButton
            label="Next match"
            disabled={!rendered.matches}
            onClick={() => setActiveMatch((activeMatch + 1) % rendered.matches)}
          >
            <ChevronDown size={17} />
          </IconButton>
          <IconButton
            label="Close search"
            onClick={() => {
              setFinder(false)
              setQuery('')
            }}
          >
            <X size={17} />
          </IconButton>
        </div>
      )}

      <main className="reading-page">
        {error ? (
          <div className="reader-message" role="alert">
            <p>{error}</p>
            <button
              className="button"
              onClick={() => {
                setError('')
                setAttempt(attempt + 1)
              }}
            >
              Try again
            </button>
          </div>
        ) : !chapter ? (
          <div className="reader-message" role="status">
            <LoaderCircle className="spin" size={24} />
            <span>Opening chapter...</span>
          </div>
        ) : (
          <>
            <div className="chapter-heading">
              <div className="eyebrow">Chapter {String(index + 1).padStart(2, '0')}</div>
              <h1>{chapterTitle(chapter.title)}</h1>
              <div className="chapter-meta">
                <span>{readingTime(chapter.wordCount)} read</span>
                <span className="meta-dot" />
                <span>{book.title}</span>
              </div>
              <div className="chapter-rule" />
            </div>
            <article
              ref={articleRef}
              className="chapter-body"
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
            <div className="chapter-ending">
              <span className="ending-ornament">*</span>
              <p>End of chapter {index + 1}</p>
              {index < book.chapters.length - 1 ? (
                <button className="button primary" onClick={() => goTo(index + 1)}>
                  Next chapter <ArrowRight size={17} />
                </button>
              ) : (
                <button
                  className="button primary"
                  onClick={async () => {
                    trackRef.current = false
                    const saved = await onFinish(book)
                    if (saved) navigate(`/books/${book.id}`)
                    else trackRef.current = true
                  }}
                >
                  <Check size={17} /> Finish book
                </button>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="reader-footer">
        <div className="chapter-progress" style={{ width: `${offset * 100}%` }} />
        <button
          className="chapter-nav"
          aria-label="Previous chapter"
          disabled={index === 0}
          onClick={() => goTo(index - 1)}
        >
          <ChevronLeft size={20} />
          <span>Previous</span>
        </button>
        <button className="reader-location" onClick={() => setPanel('contents')}>
          <span>
            Chapter {index + 1} <span className="muted">of {book.chapters.length}</span>
          </span>
          <span className="meta-dot" />
          <span className="muted">{Math.round(offset * 100)}%</span>
        </button>
        <button
          className="chapter-nav"
          aria-label="Next chapter"
          disabled={index === book.chapters.length - 1}
          onClick={() => goTo(index + 1)}
        >
          <span>Next chapter</span>
          <ChevronRight size={20} />
        </button>
      </footer>

      {panel === 'contents' && (
        <ReaderContents
          book={book}
          index={index}
          onNavigate={goTo}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'settings' && (
        <ReadingSettings
          settings={settings}
          setSettings={setSettings}
          theme={theme}
          onTheme={onTheme}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  )
}
