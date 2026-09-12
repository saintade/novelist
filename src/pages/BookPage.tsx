import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  List,
  Clock3,
  BookOpen,
  ArrowRight,
  ArrowDownToLine,
  Search,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Languages,
} from 'lucide-react'
import { useLibrary } from '../app/library-context'
import { chapterTitle, readingProgress } from '../lib/books'
import { readLink, downloadBook, bookSourceLabel } from '../lib/library/presentation'
import { BookCover, IconButton, ProgressBar } from '../components/ui'
import { readingTime, formatNumber } from '../lib/format'
import { BookMenu } from '../components/library/BookMenu'
import { BookmarkList } from '../components/library/BookmarkList'
import { DownloadRange } from '../components/library/SourceControls'
import { TranslationRange } from '../components/library/TranslationRange'
import { useSourceDirectory } from '../lib/sources/use-source-directory'
import { sourceInventory } from '../lib/sources/repository'
import { NotFound } from './NotFoundPage'

export function BookDetails() {
  const { bookId } = useParams()
  const { books, notify } = useLibrary()
  const book = books.find((entry) => entry.id === bookId)
  const directory = useSourceDirectory(book)
  const [parameters, setParameters] = useSearchParams()
  const tab = parameters.get('tab') ?? 'chapters'
  const setTab = (value: string) => setParameters(previous => {
    const next = new URLSearchParams(previous)
    next.set('tab', value)
    return next
  })
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  if (!book) return <NotFound />
  const selectedSource = directory.sources.find(
    (source) => source.book_id === book.id && source.role !== 'metadata',
  )
  const webSource = book.format === 'WEB'
  const inventory = selectedSource ? sourceInventory(selectedSource) : []
  const downloaded = directory.downloaded.filter(
    (chapter) => chapter.source_id === selectedSource?.id,
  )
  const sourceProgress = directory.progress.find(
    (progress) => progress.source_id === selectedSource?.id,
  )
  const lastReading = book.sourceProgress?.sourceId === selectedSource?.id ? book.sourceProgress : undefined
  const resumeIndex = Math.max(
    0,
    inventory.findIndex((chapter) => chapter.url === (lastReading?.chapterUrl ?? sourceProgress?.chapter_url)),
  )
  const chapterEntries = webSource
    ? inventory.map((entry) => ({
        id: entry.url,
        title: entry.title,
        wordCount: 0,
        url: entry.url,
      }))
    : book.chapters.map((entry) => ({ ...entry, url: undefined }))
  const chapters = chapterEntries
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
            <BookMenu book={book} />
          </div>
          <h1>{book.title}</h1>
          <p className="overview-author">by {book.author}</p>
          <p className="book-source-identity" title={book.sourceUrl || book.source}>
            {bookSourceLabel(book)} / {book.language}
          </p>
          <div className="book-facts">
            <span>
              <List size={15} />{' '}
              {webSource
                ? `${inventory.length} chapter links found`
                : `${book.chapters.length} chapters`}
            </span>
            {!webSource && (
              <span>
                <Clock3 size={15} /> {readingTime(book.wordCount)}
              </span>
            )}
            {!webSource && <span className="format-tag">{book.format}</span>}
          </div>
          <div className="overview-progress">
            {webSource ? (
              <span>
                {downloaded.length} of {inventory.length} chapters downloaded
              </span>
            ) : (
              <>
                <ProgressBar value={readingProgress(book)} />
                <span>{readingProgress(book)}% complete</span>
              </>
            )}
          </div>
          <div className="overview-actions">
            {webSource ? (
              selectedSource && inventory.length > 0 ? (
                <Link
                  className="button primary"
                  to={lastReading ? readLink({ ...book, progress: { ...book.progress, chapter: resumeIndex } }) : `/read-source/${book.id}/${selectedSource.id}/${resumeIndex}`}
                >
                  <BookOpen size={17} />
                  {sourceProgress || lastReading ? 'Continue reading' : 'Start reading'}
                </Link>
              ) : (
                <span className="muted">No chapters indexed</span>
              )
            ) : (
              <Link className="button primary" to={readLink(book)}>
                <BookOpen size={17} />
                {book.status === 'reading'
                  ? 'Continue reading'
                  : book.status === 'finished'
                    ? 'Read again'
                    : 'Start reading'}
                <ArrowRight size={17} />
              </Link>
            )}
            <Link
              className="button"
              to={`/books/${book.id}/translation${selectedSource ? `?source=${selectedSource.id}` : ''}`}
            >
              <Languages size={17} /> Translation
            </Link>
          </div>
        </div>
      </section>
      <section className="synopsis-section">
        <div className="section-heading">
          <h2>Synopsis</h2>
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
        {directory.error && (
          <p role="alert" className="form-error">
            {directory.error}
          </p>
        )}
        <div className="filter-tabs" role="tablist" aria-label="Book information">
          <button role="tab" aria-selected={tab === 'chapters'} onClick={() => setTab('chapters')}>
            {webSource ? 'Contents' : 'Chapters'} <span>{chapterEntries.length}</span>
          </button>
          <button id="book-tab-downloads" role="tab" aria-controls="book-downloads" aria-selected={tab === 'downloads'} onClick={() => setTab('downloads')}>
            Downloads
          </button>
          {webSource && <button id="book-tab-translate" role="tab" aria-controls="book-translate" aria-selected={tab === 'translate'} onClick={() => setTab('translate')}>Translate</button>}
          <button
            role="tab"
            aria-selected={tab === 'bookmarks'}
            onClick={() => setTab('bookmarks')}
          >
            Bookmarks <span>{book.bookmarks.length}</span>
          </button>
          <button id="book-tab-metadata" role="tab" aria-selected={tab === 'metadata'} onClick={() => setTab('metadata')}>
            Metadata
          </button>
        </div>
        <div id="book-downloads" role="tabpanel" aria-labelledby="book-tab-downloads" hidden={tab !== 'downloads'}>
          {webSource ? selectedSource ? (
            <DownloadRange key={selectedSource.id} sources={[selectedSource]} downloaded={downloaded} onSaved={directory.refresh} />
          ) : <p className="empty-inline">No reading source saved.</p> : (
            <button className="button" onClick={() => void downloadBook(book, notify)}>
              <ArrowDownToLine size={17} /> Download original book
            </button>
          )}
        </div>
        {webSource && <div id="book-translate" role="tabpanel" aria-labelledby="book-tab-translate" hidden={tab !== 'translate'}><TranslationRange key={book.id} book={book} source={selectedSource} active={tab === 'translate'} /></div>}
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
              <span>
                {chapters.length} {webSource ? 'chapter links' : 'chapters'}
              </span>
            </div>
            <div className="chapter-list">
              {chapters.slice(page * 50, (page + 1) * 50).map((chapter) => (
                <Link
                  key={chapter.id}
                  to={
                    webSource && selectedSource
                      ? `/read-source/${book.id}/${selectedSource.id}/${chapter.index}`
                      : `/read/${book.id}/${chapter.index}`
                  }
                  className={`chapter-list-item ${(webSource ? (lastReading?.chapterUrl ?? sourceProgress?.chapter_url) === chapter.url : book.status === 'reading' && book.progress.chapter === chapter.index) ? 'active' : ''}`}
                >
                  <span className="toc-number">{String(chapter.index + 1).padStart(2, '0')}</span>
                  <span className="chapter-list-title">
                    {webSource ? chapter.title : chapterTitle(chapter.title)}
                    {webSource && (
                      <small>
                        {downloaded.some((entry) => entry.url === chapter.url)
                          ? 'Downloaded'
                          : 'Download on open'}
                      </small>
                    )}
                    {(webSource
                      ? (lastReading?.chapterUrl ?? sourceProgress?.chapter_url) === chapter.url
                      : book.status === 'reading' && book.progress.chapter === chapter.index) && (
                      <small>Currently reading</small>
                    )}
                  </span>
                  {!webSource && (
                    <span className="chapter-read-time">{readingTime(chapter.wordCount)}</span>
                  )}
                  <ChevronRight size={16} />
                </Link>
              ))}
              {!chapters.length && (
                <div className="empty-inline">
                  {webSource && !query ? 'No chapter links saved.' : 'No matching chapters.'}
                </div>
              )}
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
        ) : tab === 'metadata' ? (
          <div role="tabpanel" aria-labelledby="book-tab-metadata">
            <div className="book-metadata-actions">
              {(selectedSource?.url || book.sourceUrl) && <a className="button" href={selectedSource?.url || book.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open source</a>}
                {directory.sources.filter(source => source.role === 'metadata' && source.url).map(source => (
                  <a className="button" key={source.id} href={source.url!} target="_blank" rel="noreferrer"><ExternalLink size={15} />{source.label}</a>
                ))}
              <Link className="button metadata-manage" to={`/books/${book.id}/translation?tab=metadata`}>Manage metadata<ArrowRight size={15} /></Link>
            </div>
          <dl className="file-details">
            <div>
              <dt>Genre</dt>
              <dd>{book.genre || 'Not specified'}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                {selectedSource?.url || book.sourceUrl ? (
                  <a href={selectedSource?.url || book.sourceUrl} target="_blank" rel="noreferrer">
                    {bookSourceLabel(book)}
                    <ExternalLink size={13} />
                  </a>
                ) : (
                  book.source
                )}
              </dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>
                {(selectedSource?.language || book.language) === 'en'
                  ? 'English'
                  : selectedSource?.language || book.language}
              </dd>
            </div>
            {!webSource && <div>
              <dt>Format</dt>
              <dd>{book.format}</dd>
            </div>}
            <div>
              <dt>Words</dt>
              <dd>
                {webSource
                  ? downloaded.length
                    ? `${formatNumber(downloaded.reduce((total, chapter) => total + chapter.word_count, 0))} downloaded`
                    : 'Not downloaded'
                  : formatNumber(book.wordCount)}
              </dd>
            </div>
            {!webSource && <div>
              <dt>Original file size</dt>
              <dd>{`${(book.size / 1024).toFixed(0)} KB`}</dd>
            </div>}
            <div>
              <dt>Added</dt>
              <dd>
                {new Date(book.addedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </dd>
            </div>
          </dl>
          </div>
        ) : null}
      </section>
    </main>
  )
}
