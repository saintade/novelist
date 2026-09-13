import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Bookmark as BookmarkIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  List,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Search,
  Settings2,
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
import type { ReaderChatContext } from '../lib/reader/chat'
import { ReaderChat } from './reader/ReaderChat'
import '../styles/reader.css'

const readerChatEnabled = false

interface ReaderProps {
  book: LibraryBook
  theme: 'light' | 'dark'
  onTheme: (theme: 'light' | 'dark') => void
  onProgress: (bookId: string, chapter: number, offset: number, observedAt: number) => Promise<void>
  onBookmark: (
    bookId: string,
    chapter: number,
    offset: number,
    existingId?: string,
  ) => Promise<void>
  onFinish: (book: LibraryBook) => Promise<boolean>
  loadChapter?: (bookId: string, index: number) => Promise<Chapter | undefined>
  chapterPath?: (index: number) => string
  bookPath?: string
  chapterActions?: ReactNode
  chapterSettings?: (close: () => void) => ReactNode
  onSuggestTerm?: (text: string) => void
  terminology?: { source: string; target: string; display?: string }[]
  onEditTerm?: (source: string, target: string) => void
  onReviewTerms?: (label: string) => void
  bookmarksEnabled?: boolean
  trackingEnabled?: boolean
  chatContext?: ReaderChatContext
}

export function Reader({
  book,
  theme,
  onTheme,
  onProgress,
  onBookmark,
  onFinish,
  loadChapter = getChapter,
  chapterPath,
  bookPath,
  chapterActions,
  chapterSettings,
  onSuggestTerm,
  terminology,
  onEditTerm,
  onReviewTerms,
  bookmarksEnabled = true,
  trackingEnabled = true,
  chatContext,
}: ReaderProps) {
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
  const [panel, setPanel] = useState<'contents' | 'settings' | 'chat' | null>(null)
  const [finder, setFinder] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedText, setSelectedText] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [activeMatch, setActiveMatch] = useState(0)
  const [offset, setOffset] = useState(0)
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState(initialSettings)
  const articleRef = useRef<HTMLElement>(null)
  const offsetRef = useRef(0)
  const observedAtRef = useRef(0)
  const trackRef = useRef(false)
  const restoreRef = useRef(restorePosition(book, index, position))
  const persist = useEffectEvent((bookId: string, chapterIndex: number, fraction: number, observedAt: number) => {
    void onProgress(bookId, chapterIndex, fraction, observedAt)
  })
  const checkpoint = useEffectEvent((fraction: number) => rememberPosition(book, index, fraction))
  const load = useEffectEvent((bookId: string, chapterIndex: number) =>
    loadChapter(bookId, chapterIndex),
  )

  useEffect(() => {
    let cancelled = false
    trackRef.current = false
    load(book.id, index)
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
    if (!chapter || !trackingEnabled) { trackRef.current = false; return }
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
        observedAtRef.current = Date.now()
        persist(book.id, index, restoreRef.current, observedAtRef.current)
        setReady(true)
      })
    }
    if (document.fonts) void document.fonts.ready.then(restore)
    else restore()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [chapter, book.id, index, trackingEnabled])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const handleScroll = () => {
        if (!trackRef.current || document.querySelector('dialog[open]')) return
        const maximum = document.documentElement.scrollHeight - window.innerHeight
        const fraction = maximum > 0 ? Math.min(1, Math.max(0, window.scrollY / maximum)) : 1
        if (Math.abs(fraction - offsetRef.current) < 0.00001) return
        offsetRef.current = fraction
        observedAtRef.current = Date.now()
        checkpoint(fraction)
        setOffset(fraction)
        clearTimeout(timer)
        const observedAt = observedAtRef.current
        timer = setTimeout(() => {
          if (trackRef.current) persist(book.id, index, fraction, observedAt)
        }, 400)
    }
    const handleHide = () => {
      if (trackRef.current) { checkpoint(offsetRef.current); persist(book.id, index, offsetRef.current, observedAtRef.current) }
    }
    const visibilityChanged = () => { if (document.visibilityState === 'hidden') handleHide() }
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('pagehide', handleHide)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('pagehide', handleHide)
      document.removeEventListener('visibilitychange', visibilityChanged)
      clearTimeout(timer)
      if (trackRef.current) persist(book.id, index, offsetRef.current, observedAtRef.current)
    }
  }, [book.id, index])

  useEffect(() => {
    writeSetting('novelist-reader', settings)
  }, [settings])
  useEffect(() => {
    document.title = `${chapterTitle(book.chapters[index].title)} | Novelist`
  }, [book, index])

  useEffect(() => {
    if (!onSuggestTerm) return
    const selectionChanged = () => {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''
      setSelectedText(
        selection?.anchorNode &&
          selection.focusNode &&
          articleRef.current?.contains(selection.anchorNode) &&
          articleRef.current.contains(selection.focusNode) &&
          text.length <= 160
          ? text
          : '',
      )
    }
    document.addEventListener('selectionchange', selectionChanged)
    return () => document.removeEventListener('selectionchange', selectionChanged)
  }, [onSuggestTerm])

  const goTo = (chapterIndex: number, at?: number) => {
    if (chapterIndex < 0 || chapterIndex >= book.chapters.length) return
    setPanel(null)
    const path = chapterPath?.(chapterIndex) ?? `/read/${book.id}/${chapterIndex}`
    navigate(`${path}${at !== undefined ? `${path.includes('?') ? '&' : '?'}at=${at}` : ''}`)
  }

  const keyNavigation = useEffectEvent((event: KeyboardEvent) => {
    if (
      panel ||
      document.querySelector('dialog[open]') ||
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

  const rendered = chapter
    ? chapterMarkup(chapter, deferredQuery, terminology)
    : { html: '', matches: 0 }
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
      data-reading-ready={ready && trackingEnabled}
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
        <Link
          className="reader-back"
          aria-label="Back to book details"
          to={bookPath ?? `/books/${book.id}`}
        >
          <ArrowLeft size={19} />
          <span>Library</span>
        </Link>
        <div className="reader-title">
          <span>{book.title}</span>
          <small>{book.author}</small>
        </div>
        <div className="reader-tools">
          {readerChatEnabled && <IconButton label="Ask about chapter" disabled={!chapter || !ready || !trackingEnabled} onClick={() => setPanel('chat')}><MessageSquare size={19} /></IconButton>}
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
              <nav className="reader-chapter-navigation chapter-heading-controls" aria-label="Top chapter navigation">
                <button
                  className="button"
                  aria-label="Previous chapter at top"
                  disabled={index === 0}
                  onClick={() => goTo(index - 1)}
                >
                  <ChevronLeft size={18} />
                  Previous
                </button>
                <button
                  className="button"
                  aria-label="Next chapter at top"
                  disabled={index === book.chapters.length - 1}
                  onClick={() => goTo(index + 1)}
                >
                  Next chapter
                  <ChevronRight size={18} />
                </button>
              </nav>
              <div className="eyebrow">Chapter {String(index + 1).padStart(2, '0')}</div>
              <h1>{chapterTitle(chapter.title)}</h1>
              <div className="chapter-rule" />
            </div>
            <article
              ref={articleRef}
              className="chapter-body"
              onClick={(event) => {
                const target = event.target as Element
                const term = target.closest<HTMLButtonElement>('button.reader-term')
                if (term?.dataset.ambiguousTerm) onReviewTerms?.(term.dataset.ambiguousTerm)
                else if (term?.dataset.sourceTerm && term.dataset.targetTerm)
                  onEditTerm?.(term.dataset.sourceTerm, term.dataset.targetTerm)
              }}
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
            <div className="chapter-ending">
              <span className="ending-ornament">*</span>
              <p>End of chapter {index + 1}</p>
              <nav className="reader-chapter-navigation" aria-label="Chapter navigation">
                <button
                  className="button"
                  aria-label="Previous chapter"
                  disabled={index === 0}
                  onClick={() => goTo(index - 1)}
                >
                  <ChevronLeft size={18} />
                  Previous
                </button>
                <button
                  className="button"
                  aria-label="Next chapter"
                  disabled={index === book.chapters.length - 1}
                  onClick={() => goTo(index + 1)}
                >
                  Next chapter
                  <ChevronRight size={18} />
                </button>
              </nav>
              {index === book.chapters.length - 1 && (
                <button
                  className="button primary"
                  onClick={async () => {
                    trackRef.current = false
                    const saved = await onFinish(book)
                    if (saved) navigate(bookPath ?? `/books/${book.id}`)
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

      {selectedText && onSuggestTerm && (
        <button
          className="button reader-selection-action"
          title="Save a preferred translation for the highlighted term"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const text = selectedText
            window.getSelection()?.removeAllRanges()
            setSelectedText('')
            onSuggestTerm(text)
          }}
        >
          <Pencil size={16} />
          Suggest term
        </button>
      )}
      <footer className="reader-footer">
        <div className="chapter-progress" style={{ width: `${offset * 100}%` }} />
        <div className="reader-footer-left">
        <button
          className="reader-location"
          aria-label="Table of contents"
          title={`Chapter ${index + 1} of ${book.chapters.length} / ${Math.round(offset * 100)}%`}
          onClick={() => setPanel('contents')}
        >
          <List size={19} />
        </button>
        </div>
        <div className="reader-footer-center">
          {chapterActions}
        </div>
        <div className="reader-footer-tools">
          <IconButton label="Reading settings" onClick={() => setPanel('settings')}>
            <Settings2 size={19} />
          </IconButton>
        </div>
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
          chapterControls={<>
            {bookmarksEnabled && <button className="button" aria-pressed={Boolean(bookmark)} onClick={() => void onBookmark(book.id, index, offset, bookmark?.id)}>
              <BookmarkIcon size={18} fill={bookmark ? 'currentColor' : 'none'} />
              {bookmark ? 'Remove bookmark' : 'Bookmark this position'}
            </button>}
            {chapterSettings?.(() => setPanel(null))}
          </>}
        />
      )}
      {readerChatEnabled && panel === 'chat' && chapter && <ReaderChat context={chatContext ?? { bookId: book.id, sourceKey: `local:${index}` }} chapterTitle={chapter.title} onClose={() => setPanel(null)} />}
    </div>
  )
}
