import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  List,
  Clock3,
  BookOpen,
  ArrowRight,
  ArrowDownToLine,
  Pencil,
  Search,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
} from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { chapterTitle, readingProgress } from '../lib/books'
import { readLink, statusLabel, downloadBook } from '../lib/library/presentation'
import { BookCover, IconButton, ProgressBar } from '../components/ui'
import { readingTime, formatNumber } from '../lib/format'
import { BookMenu } from '../components/library/BookMenu'
import { EditBookDialog } from '../components/library/EditBookDialog'
import { BookmarkList } from '../components/library/BookmarkList'
import { NotFound } from './NotFoundPage'

export function BookDetails() {
  const { bookId } = useParams()
  const { books, patchBook, notify } = useLibrary()
  const book = books.find((entry) => entry.id === bookId)
  const [tab, setTab] = useState<'chapters' | 'bookmarks' | 'details'>('chapters')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [edit, setEdit] = useState(false)
  if (!book) return <NotFound />
  const chapters = book.chapters
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) =>
      `${entry.index + 1} ${entry.title}`.toLowerCase().includes(query.toLowerCase()),
    )
  return (
    <main className="details-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> Back to library
      </Link>
      <section className="book-overview">
        <BookCover book={book} className="details-cover" />
        <div className="overview-content">
          <div className="overview-top">
            <span className="genre-label">{book.genre}</span>
            <BookMenu book={book} />
          </div>
          <h1>{book.title}</h1>
          <p className="overview-author">by {book.author}</p>
          <div className="book-facts">
            <span>
              <List size={15} /> {book.chapters.length} chapters
            </span>
            <span>
              <Clock3 size={15} /> {readingTime(book.wordCount)}
            </span>
            <span className="format-tag">{book.format}</span>
            <span className={`status-label status-${book.status}`}>
              <span />
              {statusLabel(book)}
            </span>
          </div>
          <div className="overview-progress">
            <ProgressBar value={readingProgress(book)} />
            <span>{readingProgress(book)}% complete</span>
          </div>
          <div className="overview-actions">
            <Link className="button primary" to={readLink(book)}>
              <BookOpen size={17} />
              {book.status === 'reading'
                ? 'Continue reading'
                : book.status === 'finished'
                  ? 'Read again'
                  : 'Start reading'}
              <ArrowRight size={17} />
            </Link>
            <IconButton
              label="Download original book"
              onClick={() => {
                void downloadBook(book, notify)
              }}
            >
              <ArrowDownToLine size={19} />
            </IconButton>
            <IconButton label="Edit book details" onClick={() => setEdit(true)}>
              <Pencil size={17} />
            </IconButton>
          </div>
        </div>
      </section>
      <section className="synopsis-section">
        <div className="section-heading">
          <h2>Synopsis</h2>
          <button className="text-button" onClick={() => setEdit(true)}>
            <Pencil size={14} /> Edit
          </button>
        </div>
        <div className="synopsis-text">
          {book.description ? (
            book.description.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)
          ) : (
            <p className="muted">No synopsis added.</p>
          )}
        </div>
      </section>
      <section className="contents-section">
        <div className="filter-tabs" role="tablist" aria-label="Book information">
          <button role="tab" aria-selected={tab === 'chapters'} onClick={() => setTab('chapters')}>
            Chapters <span>{book.chapters.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'bookmarks'}
            onClick={() => setTab('bookmarks')}
          >
            Bookmarks <span>{book.bookmarks.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>
            File details
          </button>
        </div>
        {tab === 'chapters' ? (
          <>
            <div className="contents-toolbar">
              <label className="search-field">
                <Search size={17} />
                <input
                  aria-label="Search table of contents"
                  placeholder="Find a chapter..."
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(0)
                  }}
                />
              </label>
              <span>{chapters.length} chapters</span>
            </div>
            <div className="chapter-list">
              {chapters.slice(page * 50, (page + 1) * 50).map((chapter) => (
                <Link
                  key={chapter.id}
                  to={`/read/${book.id}/${chapter.index}`}
                  className={`chapter-list-item ${book.status === 'reading' && book.progress.chapter === chapter.index ? 'active' : ''}`}
                >
                  <span className="toc-number">{String(chapter.index + 1).padStart(2, '0')}</span>
                  <span className="chapter-list-title">
                    {chapterTitle(chapter.title)}
                    {book.status === 'reading' && book.progress.chapter === chapter.index && (
                      <small>Currently reading</small>
                    )}
                  </span>
                  <span className="chapter-read-time">{readingTime(chapter.wordCount)}</span>
                  <ChevronRight size={16} />
                </Link>
              ))}
              {!chapters.length && <div className="empty-inline">No matching chapters.</div>}
            </div>
            {chapters.length > 50 && (
              <div className="pagination">
                <IconButton
                  label="Previous chapter list page"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={18} />
                </IconButton>
                <span>
                  {page + 1} / {Math.ceil(chapters.length / 50)}
                </span>
                <IconButton
                  label="Next chapter list page"
                  disabled={(page + 1) * 50 >= chapters.length}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={18} />
                </IconButton>
              </div>
            )}
          </>
        ) : tab === 'bookmarks' ? (
          <BookmarkList books={[book]} />
        ) : (
          <dl className="file-details">
            <div>
              <dt>Source</dt>
              <dd>
                {book.sourceUrl ? (
                  <a href={book.sourceUrl} target="_blank" rel="noreferrer">
                    {book.source}
                    <ExternalLink size={13} />
                  </a>
                ) : (
                  book.source
                )}
              </dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{book.language === 'en' ? 'English' : book.language}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>{book.format}</dd>
            </div>
            <div>
              <dt>Words</dt>
              <dd>{formatNumber(book.wordCount)}</dd>
            </div>
            <div>
              <dt>Original file size</dt>
              <dd>{(book.size / 1024).toFixed(0)} KB</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>
                {new Date(book.addedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </dd>
            </div>
          </dl>
        )}
      </section>
      {edit && (
        <EditBookDialog
          book={book}
          onClose={() => setEdit(false)}
          onSave={async (changes) => {
            const saved = await patchBook(book.id, (current) => ({ ...current, ...changes }))
            if (saved) {
              setEdit(false)
              notify('Book details updated.')
            }
            return saved
          }}
        />
      )}
    </main>
  )
}
